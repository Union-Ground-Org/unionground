import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// Three-year lived-in catalog for the SAMPLE demo seed.
//
// Owner request 2026-08-20: the SAMPLE database should read as a Cedar Ridge
// DDS chapter that has been using the product since mid-2023 — ballots,
// pulses, charts, and communication included. Every user-visible string stays
// unlabeled; the origin is the demo boundary. Production Postgres is never
// a target of this module.
import { createHash } from "node:crypto";

export const SAMPLE_HISTORY_YEARS = 3;
export const SAMPLE_HISTORY_WEEKS = SAMPLE_HISTORY_YEARS * 52;
export const SAMPLE_CHAPTER_QUORUM = 22;

export const POINT_RULES = Object.freeze({
  vote: 20,
  survey: 10,
  rights: 15,
  case: 25,
  message: 2,
  rsvp: 40,
  checkin: 50,
  workload: 10,
});

export const RIGHTS_LESSONS = Object.freeze(["weingarten", "loudermill", "safety", "harassment", "pip"]);

// Migration-seeded rows a visitor still reads as demo content. Exact ids,
// never a pattern: the reconcile step deletes, and these titles include
// "Fictional Public Service Chapter" or point at Pine Harbor/Maple Crossing rather
// than Cedar Ridge Care Services.
export const PLACEHOLDER_BALLOT_IDS = Object.freeze([
  "ballot-2026",
  "ballot-2025-contract",
  "ballot-2025-bylaws",
]);

export const PLACEHOLDER_SURVEY_IDS = Object.freeze([
  "pulse-new-members",
  "pulse-2025-caseload",
  "pulse-2025-safety",
]);

export const PLACEHOLDER_EVENT_IDS = Object.freeze([
  "evt-2026-chapter-meeting",
  "evt-2026-steward-training",
  "evt-2026-office-hours",
  "evt-2026-relief-rally",
  "evt-2026-ratification-call",
  "evt-2025-fall-assembly",
  "evt-2025-caseload-forum",
  "evt-2026-winter-training",
  "evt-2026-lobby-day",
]);

export const PLACEHOLDER_KB_SLUGS = Object.freeze([
  "contract-article-3-union-rights-and-representation",
  "contract-article-5-grievance-procedure",
  "contract-article-7-hours-of-work",
  "contract-article-12-discipline",
  "contract-article-16-health-and-safety",
  "contract-article-24-telework",
  "faq-file-a-grievance",
  "faq-weingarten-rights",
  "faq-dues-and-fair-share",
]);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function digestBytes(...parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest();
}

export function hashMod(modulo, ...parts) {
  return digestBytes(...parts).readUInt32BE(0) % modulo;
}

export function participates(memberKey, entityId, percent) {
  return hashMod(100, "turnout", memberKey, entityId) < percent;
}

export function optionIndex(memberKey, entityId, count, biasFirst = 58) {
  if (count <= 1) return 0;
  const roll = hashMod(100, "choice", memberKey, entityId);
  if (roll < biasFirst) return 0;
  return 1 + (hashMod(count - 1, "choice-rest", memberKey, entityId));
}

export function crockfordCode(length, ...parts) {
  const bytes = digestBytes("crockford", ...parts);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CROCKFORD[bytes[index] % CROCKFORD.length];
  }
  return out;
}

export function ballotReceiptCode(memberKey, ballotId) {
  return `SG-${crockfordCode(4, memberKey, ballotId, "a")}-${crockfordCode(4, memberKey, ballotId, "b")}`;
}

export function hex8(...parts) {
  return digestBytes("hex8", ...parts).toString("hex").slice(0, 8);
}

// The rest of the chapter beyond the ten members the original SAMPLE seed
// carried. Plain members, no passwords, so desks and tallies read like a
// working Cedar Ridge Care Services chapter instead of a sixteen-row fixture.
export const EXTRA_CHAPTER_MEMBERS = Object.freeze([
  { key: "elena.costa", firstName: "Elena", fullName: "Elena Costa", initials: "EC", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2017 },
  { key: "jamal.wright", firstName: "Jamal", fullName: "Jamal Wright", initials: "JW", roleLine: "Day program instructor · Cedar Ridge Care Services", memberSince: 2020 },
  { key: "sofia.mendes", firstName: "Sofia", fullName: "Sofia Mendes", initials: "SM", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2022 },
  { key: "patrick.doherty", firstName: "Patrick", fullName: "Patrick Doherty", initials: "PD", roleLine: "Maintenance technician · Cedar Ridge Care Services", memberSince: 2013 },
  { key: "aisha.kane", firstName: "Aisha", fullName: "Aisha Kane", initials: "AK", roleLine: "Vocational specialist · Cedar Ridge Care Services", memberSince: 2018 },
  { key: "diego.ramos", firstName: "Diego", fullName: "Diego Ramos", initials: "DR", roleLine: "Transportation driver · Cedar Ridge Care Services", memberSince: 2016 },
  { key: "maeve.flaherty", firstName: "Maeve", fullName: "Maeve Flaherty", initials: "MF", roleLine: "Case manager · Cedar Ridge Care Services", memberSince: 2011 },
  { key: "henry.okonkwo", firstName: "Henry", fullName: "Henry Okonkwo", initials: "HO", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2021 },
  { key: "nia.boateng", firstName: "Nia", fullName: "Nia Boateng", initials: "NB", roleLine: "Clinical coordinator · Cedar Ridge Care Services", memberSince: 2019 },
  { key: "carlos.vieira", firstName: "Carlos", fullName: "Carlos Vieira", initials: "CV", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2015 },
  { key: "bridget.mcgrath", firstName: "Bridget", fullName: "Bridget McGrath", initials: "BM", roleLine: "Day program instructor · Cedar Ridge Care Services", memberSince: 2014 },
  { key: "owen.kelly", firstName: "Owen", fullName: "Owen Kelly", initials: "OK", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2023 },
  { key: "fatima.diallo", firstName: "Fatima", fullName: "Fatima Diallo", initials: "FD", roleLine: "Vocational specialist · Cedar Ridge Care Services", memberSince: 2020 },
  { key: "james.oconnor", firstName: "James", fullName: "James O'Connor", initials: "JO", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2012 },
  { key: "yara.santos", firstName: "Yara", fullName: "Yara Santos", initials: "YS", roleLine: "Case manager · Cedar Ridge Care Services", memberSince: 2018 },
  { key: "michael.riley", firstName: "Michael", fullName: "Michael Riley", initials: "MR", roleLine: "Transportation driver · Cedar Ridge Care Services", memberSince: 2017 },
  { key: "keisha.bennett", firstName: "Keisha", fullName: "Keisha Bennett", initials: "KB", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2019 },
  { key: "luis.ferreira", firstName: "Luis", fullName: "Luis Ferreira", initials: "LF", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2016 },
  { key: "claire.donovan", firstName: "Claire", fullName: "Claire Donovan", initials: "CD", roleLine: "Chapter office administrator · Cedar Ridge Care Services", memberSince: 2010 },
  { key: "samuel.owusu", firstName: "Samuel", fullName: "Samuel Owusu", initials: "SOW", roleLine: "Day program instructor · Cedar Ridge Care Services", memberSince: 2021 },
  { key: "renee.pelletier", firstName: "Renee", fullName: "Renee Pelletier", initials: "RP", roleLine: "Clinical coordinator · Cedar Ridge Care Services", memberSince: 2014 },
  { key: "anthony.barros", firstName: "Anthony", fullName: "Anthony Barros", initials: "ABR", roleLine: "Maintenance technician · Cedar Ridge Care Services", memberSince: 2018 },
  { key: "grace.nkrumah", firstName: "Grace", fullName: "Grace Nkrumah", initials: "GN", roleLine: "Direct support professional · Cedar Ridge Care Services", memberSince: 2022 },
  { key: "daniel.shea", firstName: "Daniel", fullName: "Daniel Shea", initials: "DS", roleLine: "Residential counselor · Cedar Ridge Care Services", memberSince: 2013 },
].map((member) => Object.freeze({
  ...member,
  email: `${member.key}@demo.example.com`,
  roles: Object.freeze([]),
  signIn: false,
})));

function option(id, label, labelEs, orderIndex) {
  return Object.freeze({ id, label, labelEs, orderIndex });
}

export const SAMPLE_BALLOTS = Object.freeze([
  {
    id: "ballot-wor-2026-steward-slate",
    title: "Confirm the 2026–2027 steward slate",
    titleEs: "Confirmar la lista de delegados 2026–2027",
    body: "Nominations closed at the August membership meeting. The nominated slate is Sam Okafor, chapter steward, with Rosa Almeida as alternate.",
    bodyEs: "Las nominaciones cerraron en la asamblea de agosto. La lista nominada es Sam Okafor, delegado del capítulo, con Rosa Almeida como suplente.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 10,
    publishedDaysAgo: 18,
    closesInDays: 11,
    closed: false,
    turnoutPercent: 64,
    options: [
      option("ballot-wor-2026-steward-slate-yes", "Yes — confirm the slate", "Sí — confirmar la lista", 1),
      option("ballot-wor-2026-steward-slate-no", "No — reopen nominations", "No — reabrir nominaciones", 2),
      option("ballot-wor-2026-steward-slate-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2026-scheduling-petition",
    title: "Endorse the weekend-rota petition as chapter policy",
    titleEs: "Respaldar la petición del turno de fin de semana como política del capítulo",
    body: "Two hundred eleven signatures are already on the sheet. This vote asks the chapter to take the petition to the agency as our shared demand.",
    bodyEs: "Ya hay doscientas once firmas. Esta votación pide al capítulo llevar la petición a la agencia como demanda compartida.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 11,
    publishedDaysAgo: 48,
    closesInDays: -12,
    closed: true,
    turnoutPercent: 78,
    options: [
      option("ballot-wor-2026-scheduling-petition-yes", "Endorse and send it", "Respaldar y enviarla", 1),
      option("ballot-wor-2026-scheduling-petition-no", "Hold for more signatures", "Esperar más firmas", 2),
      option("ballot-wor-2026-scheduling-petition-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2026-spring-steward",
    title: "2026 spring steward election",
    titleEs: "Elección de delegados de primavera 2026",
    body: "Vote for the steward team that will hold the desk through next spring.",
    bodyEs: "Vote por el equipo de delegados que ocupará el escritorio hasta la próxima primavera.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 12,
    publishedDaysAgo: 175,
    closesInDays: -158,
    closed: true,
    turnoutPercent: 81,
    options: [
      option("ballot-wor-2026-spring-steward-okafor", "Sam Okafor", "Sam Okafor", 1),
      option("ballot-wor-2026-spring-steward-almeida", "Rosa Almeida", "Rosa Almeida", 2),
      option("ballot-wor-2026-spring-steward-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2025-contract",
    title: "Ratify the 2025–2028 successor agreement",
    titleEs: "Ratificar el acuerdo sucesor 2025–2028",
    body: "The bargaining team recommends ratification. Article 7 scheduling language and the overtime cap are the headline changes.",
    bodyEs: "El equipo de negociación recomienda la ratificación. El lenguaje de horarios del Artículo 7 y el tope de horas extra son los cambios principales.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 13,
    publishedDaysAgo: 430,
    closesInDays: -400,
    closed: true,
    turnoutPercent: 88,
    options: [
      option("ballot-wor-2025-contract-yes", "Yes — ratify", "Sí — ratificar", 1),
      option("ballot-wor-2025-contract-no", "No — return to talks", "No — volver a la mesa", 2),
      option("ballot-wor-2025-contract-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2025-bylaws",
    title: "Adopt the revised chapter bylaws",
    titleEs: "Adoptar los estatutos revisados del capítulo",
    body: "The revision aligns steward elections with the membership-meeting calendar and clarifies the health-and-safety committee seat.",
    bodyEs: "La revisión alinea las elecciones de delegados con el calendario de asambleas y aclara el asiento del comité de salud y seguridad.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 14,
    publishedDaysAgo: 520,
    closesInDays: -490,
    closed: true,
    turnoutPercent: 71,
    options: [
      option("ballot-wor-2025-bylaws-yes", "Adopt the revision", "Adoptar la revisión", 1),
      option("ballot-wor-2025-bylaws-no", "Keep the current bylaws", "Mantener los estatutos actuales", 2),
      option("ballot-wor-2025-bylaws-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2025-spring-steward",
    title: "2025 spring steward election",
    titleEs: "Elección de delegados de primavera 2025",
    body: "Annual steward election for Cedar Ridge Care Services.",
    bodyEs: "Elección anual de delegados para Cedar Ridge Care Services.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 15,
    publishedDaysAgo: 540,
    closesInDays: -510,
    closed: true,
    turnoutPercent: 76,
    options: [
      option("ballot-wor-2025-spring-steward-okafor", "Sam Okafor", "Sam Okafor", 1),
      option("ballot-wor-2025-spring-steward-whelan", "Kathleen Whelan", "Kathleen Whelan", 2),
      option("ballot-wor-2025-spring-steward-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2024-overtime-moa",
    title: "Approve the overtime-equalization memorandum",
    titleEs: "Aprobar el memorando de igualación de horas extra",
    body: "The memorandum caps consecutive mandated shifts and rotates weekend overtime by seniority on the posted list.",
    bodyEs: "El memorando limita los turnos mandatorios consecutivos y rota las horas extra de fin de semana por antigüedad en la lista publicada.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 16,
    publishedDaysAgo: 780,
    closesInDays: -750,
    closed: true,
    turnoutPercent: 80,
    options: [
      option("ballot-wor-2024-overtime-moa-yes", "Approve the memorandum", "Aprobar el memorando", 1),
      option("ballot-wor-2024-overtime-moa-no", "Send it back", "Devolverlo", 2),
      option("ballot-wor-2024-overtime-moa-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2024-spring-steward",
    title: "2024 spring steward election",
    titleEs: "Elección de delegados de primavera 2024",
    body: "Annual steward election for Cedar Ridge Care Services.",
    bodyEs: "Elección anual de delegados para Cedar Ridge Care Services.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 17,
    publishedDaysAgo: 900,
    closesInDays: -870,
    closed: true,
    turnoutPercent: 74,
    options: [
      option("ballot-wor-2024-spring-steward-okafor", "Sam Okafor", "Sam Okafor", 1),
      option("ballot-wor-2024-spring-steward-costa", "Elena Costa", "Elena Costa", 2),
      option("ballot-wor-2024-spring-steward-abstain", "Abstain", "Abstención", 3),
    ],
  },
  {
    id: "ballot-wor-2023-contract",
    title: "Ratify the 2023–2025 successor agreement",
    titleEs: "Ratificar el acuerdo sucesor 2023–2025",
    body: "First full successor agreement after the chapter moved onto this membership system. The bargaining team recommends yes.",
    bodyEs: "Primer acuerdo sucesor completo después de que el capítulo pasara a este sistema de membresía. El equipo de negociación recomienda sí.",
    chapterId: "wor",
    quorumTarget: SAMPLE_CHAPTER_QUORUM,
    orderIndex: 18,
    publishedDaysAgo: 1080,
    closesInDays: -1048,
    closed: true,
    turnoutPercent: 83,
    options: [
      option("ballot-wor-2023-contract-yes", "Yes — ratify", "Sí — ratificar", 1),
      option("ballot-wor-2023-contract-no", "No — return to talks", "No — volver a la mesa", 2),
      option("ballot-wor-2023-contract-abstain", "Abstain", "Abstención", 3),
    ],
  },
].map(Object.freeze));

const PULSE_TOPICS = Object.freeze([
  {
    slug: "caseload",
    title: "How manageable is your current caseload?",
    titleEs: "¿Qué tan manejable es su carga de casos actual?",
    body: "Answer for the last two weeks on your own assignment, not the house average.",
    bodyEs: "Responda por las últimas dos semanas en su propia asignación, no el promedio de la casa.",
    options: [
      ["Manageable most weeks", "Manejable la mayoría de las semanas"],
      ["Stretched but coping", "Ajustado pero aguantando"],
      ["Unsafe for people supported and staff", "Inseguro para las personas apoyadas y el personal"],
    ],
  },
  {
    slug: "safety",
    title: "Do you have what you need to work safely?",
    titleEs: "¿Tiene lo que necesita para trabajar con seguridad?",
    body: "Lift equipment, van logs, and the incident binder count. If a site is short, say so.",
    bodyEs: "Cuentan el equipo de izaje, las bitácoras de las camionetas y la carpeta de incidentes. Si un sitio está corto, dígalo.",
    options: [
      ["Yes, consistently", "Sí, de forma constante"],
      ["Sometimes", "A veces"],
      ["No", "No"],
    ],
  },
  {
    slug: "overtime",
    title: "How often were you mandated onto overtime this month?",
    titleEs: "¿Con qué frecuencia lo mandaron a horas extra este mes?",
    body: "Count only shifts you did not volunteer for.",
    bodyEs: "Cuente solo los turnos que no ofreció voluntariamente.",
    options: [
      ["Never", "Nunca"],
      ["Once or twice", "Una o dos veces"],
      ["Most weeks", "La mayoría de las semanas"],
    ],
  },
  {
    slug: "respect",
    title: "Did supervision treat you with respect this quarter?",
    titleEs: "¿La supervisión lo trató con respeto este trimestre?",
    body: "This pulse stays inside the chapter. It is not a charge and it is not anonymous to your steward if you later open a case.",
    bodyEs: "Este sondeo permanece dentro del capítulo. No es un cargo y no es anónimo para su delegado si luego abre un caso.",
    options: [
      ["Yes", "Sí"],
      ["Mixed", "Mixto"],
      ["No", "No"],
    ],
  },
]);

function buildQuarterlySurveys() {
  const rows = [];
  for (let quarter = 0; quarter < 12; quarter += 1) {
    const topic = PULSE_TOPICS[quarter % PULSE_TOPICS.length];
    const closedDaysAgo = 80 + quarter * 90;
    const publishedDaysAgo = closedDaysAgo + 21;
    rows.push(Object.freeze({
      id: `pulse-wor-${topic.slug}-q${quarter + 1}`,
      title: topic.title,
      titleEs: topic.titleEs,
      body: topic.body,
      bodyEs: topic.bodyEs,
      chapterId: "wor",
      orderIndex: 20 + quarter,
      publishedDaysAgo,
      closesInDays: -closedDaysAgo,
      closed: true,
      turnoutPercent: 62 + (quarter % 5) * 4,
      options: topic.options.map(([label, labelEs], index) => option(
        `pulse-wor-${topic.slug}-q${quarter + 1}-${index + 1}`,
        label,
        labelEs,
        index + 1,
      )),
    }));
  }
  return rows;
}

export const SAMPLE_SURVEYS = Object.freeze([
  {
    id: "pulse-wor-overtime-now",
    title: "Were you mandated onto overtime this week?",
    titleEs: "¿Lo mandaron a horas extra esta semana?",
    body: "Short pulse so the steward desk can see which sites are running hot before the membership meeting.",
    bodyEs: "Sondeo breve para que el escritorio de delegados vea qué sitios están saturados antes de la asamblea.",
    chapterId: "wor",
    orderIndex: 10,
    publishedDaysAgo: 4,
    closesInDays: 3,
    closed: false,
    turnoutPercent: 54,
    options: [
      option("pulse-wor-overtime-now-no", "No", "No", 1),
      option("pulse-wor-overtime-now-once", "Once", "Una vez", 2),
      option("pulse-wor-overtime-now-more", "More than once", "Más de una vez", 3),
    ],
  },
  {
    id: "pulse-wor-bargaining-priorities",
    title: "What should we take to the table first this fall?",
    titleEs: "¿Qué debemos llevar primero a la mesa este otoño?",
    body: "Pick the one issue you want the contract action team to lead with. You can talk to your steward about the rest.",
    bodyEs: "Elija el único tema con el que quiere que el equipo de acción contractual lidere. Puede hablar con su delegado sobre el resto.",
    chapterId: "wor",
    orderIndex: 11,
    publishedDaysAgo: 9,
    closesInDays: 16,
    closed: false,
    turnoutPercent: 48,
    options: [
      option("pulse-wor-bargaining-priorities-ot", "Mandatory overtime cap", "Tope de horas extra mandatorias", 1),
      option("pulse-wor-bargaining-priorities-staffing", "Residential staffing ratios", "Proporciones de personal residencial", 2),
      option("pulse-wor-bargaining-priorities-pay", "Shift differential on holidays", "Diferencial de turno en feriados", 3),
      option("pulse-wor-bargaining-priorities-safety", "Lift equipment and van maintenance", "Equipo de izaje y mantenimiento de camionetas", 4),
    ],
  },
  ...buildQuarterlySurveys(),
].map(Object.freeze));

function buildMonthlyMeetings() {
  const rows = [];
  for (let monthsAgo = 1; monthsAgo <= 36; monthsAgo += 1) {
    const startsInDays = -(monthsAgo * 30) - 2;
    rows.push(Object.freeze({
      id: `evt-meet-${String(monthsAgo).padStart(2, "0")}`,
      title: "Chapter membership meeting",
      startsInDays,
      startsAtHour: 17.5,
      orderIndex: 200 + monthsAgo,
      checkInCode: `SG-MT${String(200 + monthsAgo)}`,
      location: "Tamarack campaign hall · 10 Example Way",
      summary: "Contract enforcement, steward report, and an open floor for scheduling and safety.",
      isPublic: true,
      isPublicAcrossAgencies: false,
      rsvpPercent: 58,
      checkInPercent: 82,
    }));
  }
  return rows;
}

export const SAMPLE_HISTORY_EVENTS = Object.freeze([
  ...buildMonthlyMeetings(),
  {
    id: "evt-lobby-2026", title: "State House lobby day",
    startsInDays: -38, startsAtHour: 9, orderIndex: 250, checkInCode: "SG-LBY26",
    location: "Massachusetts State House · Beacon Hill",
    summary: "Human-services line-item testimony and legislator visits with the Cedar Ridge Care Services contingent.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 40, checkInPercent: 90,
  },
  {
    id: "evt-lobby-2025", title: "State House lobby day",
    startsInDays: -400, startsAtHour: 9, orderIndex: 251, checkInCode: "SG-LBY25",
    location: "Massachusetts State House · Beacon Hill",
    summary: "Budget testimony on residential staffing and overtime relief.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 36, checkInPercent: 88,
  },
  {
    id: "evt-lobby-2024", title: "State House lobby day",
    startsInDays: -760, startsAtHour: 9, orderIndex: 252, checkInCode: "SG-LBY24",
    location: "Massachusetts State House · Beacon Hill",
    summary: "First chapter lobby day after the 2023 agreement. Members brought caseload stories.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 33, checkInPercent: 85,
  },
  {
    id: "evt-train-2026-winter", title: "Winter steward training",
    startsInDays: -96, startsAtHour: 18, orderIndex: 260, checkInCode: "SG-WN26",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "Weingarten, Loudermill, and Step 1 practice against live Cedar Ridge files.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 28, checkInPercent: 92,
  },
  {
    id: "evt-train-2025-winter", title: "Winter steward training",
    startsInDays: -460, startsAtHour: 18, orderIndex: 261, checkInCode: "SG-WN25",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "New-steward module after the 2025 election.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 30, checkInPercent: 90,
  },
  {
    id: "evt-assembly-2025-fall", title: "Fall chapter assembly",
    startsInDays: -320, startsAtHour: 17, orderIndex: 270, checkInCode: "SG-FA25",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "Contract-action planning and the fall steward slate.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 70, checkInPercent: 86,
  },
  {
    id: "evt-assembly-2024-fall", title: "Fall chapter assembly",
    startsInDays: -685, startsAtHour: 17, orderIndex: 271, checkInCode: "SG-FA24",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "Overtime memorandum report-back and worksite leader training.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 66, checkInPercent: 84,
  },
  {
    id: "evt-assembly-2023-fall", title: "Fall chapter assembly",
    startsInDays: -1050, startsAtHour: 17, orderIndex: 272, checkInCode: "SG-FA23",
    location: "Tamarack campaign hall · 10 Example Way",
    summary: "First assembly after ratification. Members set the 2024 enforcement calendar.",
    isPublic: true, isPublicAcrossAgencies: false, rsvpPercent: 72, checkInPercent: 88,
  },
].map(Object.freeze));

export const SAMPLE_HISTORY_BROADCASTS = Object.freeze([
  {
    id: "bc-2026-q1-enforcement", sender: "Chapter president", orderIndex: 110, publishedDaysAgo: 140,
    title: "First-quarter enforcement: three files closed, two still live",
    body: "The overtime cap held on the residential rota. The accommodation backlog is the next fight — bring documentation to your steward this month.",
  },
  {
    id: "bc-2025-q4-ratify", sender: "Bargaining team", orderIndex: 111, publishedDaysAgo: 390,
    title: "The 2025–2028 agreement is ratified",
    body: "Cedar Ridge Care Services voted to ratify. Printed copies of Article 7 and the overtime cap are in every break room. Read them before the next schedule posting.",
  },
  {
    id: "bc-2025-q3-bylaws", sender: "Chapter administrator", orderIndex: 112, publishedDaysAgo: 500,
    title: "Bylaws revision adopted",
    body: "Steward elections now open on the floor of the membership meeting and stay open ten days. The health-and-safety committee seat is written in.",
  },
  {
    id: "bc-2025-q2-lobby", sender: "Chapter president", orderIndex: 113, publishedDaysAgo: 400,
    title: "Lobby day recap from Beacon Hill",
    body: "Eighteen Cedar Ridge members made the trip. Two offices asked for the staffing-ratio one-pager. We will send the same packet before the budget markup.",
  },
  {
    id: "bc-2025-q1-steward", sender: "Chapter steward", orderIndex: 114, publishedDaysAgo: 530,
    title: "Spring steward election results",
    body: "Sam Okafor continues as chapter steward. Thank you to everyone who voted and to Kathleen Whelan for standing.",
  },
  {
    id: "bc-2024-q4-ot", sender: "Health and safety committee", orderIndex: 115, publishedDaysAgo: 740,
    title: "Overtime memorandum is in force",
    body: "Consecutive mandated shifts are capped. If a supervisor skips the seniority list, write down the date and tell your steward the same day.",
  },
  {
    id: "bc-2024-q3-vans", sender: "Health and safety committee", orderIndex: 116, publishedDaysAgo: 820,
    title: "Van lift inspections are now monthly",
    body: "The agency agreed to a written monthly inspection after the Pinebend incident log. Keep your own copy of anything you sign.",
  },
  {
    id: "bc-2024-q2-training", sender: "Chapter steward", orderIndex: 117, publishedDaysAgo: 900,
    title: "New-steward training dates are posted",
    body: "Module 1 is Weingarten. Anyone who wants to sit in — member or steward — should tell the chapter office this week.",
  },
  {
    id: "bc-2024-q1-election", sender: "Chapter president", orderIndex: 118, publishedDaysAgo: 980,
    title: "2024 steward election is certified",
    body: "Sam Okafor holds the desk. Elena Costa finished a close second and remains the alternate for investigatory meetings.",
  },
  {
    id: "bc-2023-q4-ratify", sender: "Bargaining team", orderIndex: 119, publishedDaysAgo: 1040,
    title: "The 2023–2025 agreement is ratified",
    body: "Thank you for turning out. Printed articles are posted. The first enforcement calendar lands at the fall assembly.",
  },
  {
    id: "bc-2023-q3-welcome", sender: "Chapter administrator", orderIndex: 120, publishedDaysAgo: 1090,
    title: "Membership tools are live for Cedar Ridge Care Services",
    body: "Cases, messages, votes, and the chapter calendar now live here. If your email bounced, stop by the office with a photo ID.",
  },
].map(Object.freeze));

export const SAMPLE_HISTORY_CASES = Object.freeze([
  {
    memberKey: "elena.costa", reference: "GR-2025-410", title: "Weekend overtime skipped on the seniority list",
    caseType: "Scheduling", step: "Closed", status: "resolved",
    articles: "Article 7 — Hours of Work · Article 8 — Overtime",
    openedDaysAgo: 420, updatedDaysAgo: 360, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Filed with the posted list and the superseding text message from the house manager.",
      "Settled at Step 2. The missed shift was made whole and the list was reposted.",
    ],
  },
  {
    memberKey: "jamal.wright", reference: "GR-2025-418", title: "Investigatory meeting without a steward",
    caseType: "Discipline", step: "Closed", status: "resolved",
    articles: "Article 3 — Union Rights and Representation · Article 12 — Discipline",
    openedDaysAgo: 390, updatedDaysAgo: 310, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: [
      "Member used the Weingarten script. The meeting continued anyway.",
      "Warning withdrawn after Step 1. The agency agreed to pause future investigatory meetings until a steward arrives.",
    ],
  },
  {
    memberKey: "sofia.mendes", reference: "GR-2024-330", title: "Personal protective gloves out of stock for three weeks",
    caseType: "Safety", step: "Closed", status: "resolved",
    articles: "Article 16 — Health and Safety",
    openedDaysAgo: 700, updatedDaysAgo: 640, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Supply restored and the incident logged with the safety committee."],
  },
  {
    memberKey: "patrick.doherty", reference: "GR-2024-341", title: "Call-in denied after a documented snow emergency",
    caseType: "Leave", step: "Closed", status: "resolved",
    articles: "Article 10 — Leave",
    openedDaysAgo: 640, updatedDaysAgo: 580, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Attendance point removed. The snow emergency memo was added to the house binder.",
    ],
  },
  {
    memberKey: "aisha.kane", reference: "GR-2024-355", title: "Bilingual differential omitted on two pay cycles",
    caseType: "Pay", step: "Closed", status: "resolved",
    articles: "Article 9 — Compensation",
    openedDaysAgo: 610, updatedDaysAgo: 540, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: ["Back pay issued. Payroll coded the differential as ongoing."],
  },
  {
    memberKey: "diego.ramos", reference: "GR-2024-362", title: "Route changed without the required notice",
    caseType: "Scheduling", step: "Closed", status: "resolved",
    articles: "Article 7 — Hours of Work",
    openedDaysAgo: 560, updatedDaysAgo: 500, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Notice restored to fourteen days. The two short-notice days were paid at the overtime rate."],
  },
  {
    memberKey: "maeve.flaherty", reference: "GR-2023-218", title: "Caseload assigned above the written standard",
    caseType: "Workload", step: "Closed", status: "resolved",
    articles: "Article 18 — Workload",
    openedDaysAgo: 1000, updatedDaysAgo: 920, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Compared the assignment sheet against the 2023 standard.",
      "Two cases reassigned. The standard is now posted in the team room.",
    ],
  },
  {
    memberKey: "carlos.vieira", reference: "GR-2023-225", title: "Holiday differential missed on Thanksgiving coverage",
    caseType: "Pay", step: "Closed", status: "resolved",
    articles: "Article 9 — Compensation",
    openedDaysAgo: 980, updatedDaysAgo: 910, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Holiday differential paid on the next cycle."],
  },
  {
    memberKey: "bridget.mcgrath", reference: "GR-2023-240", title: "Training hours treated as unpaid",
    caseType: "Pay", step: "Closed", status: "resolved",
    articles: "Article 9 — Compensation · Article 20 — Training",
    openedDaysAgo: 920, updatedDaysAgo: 850, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: ["Eight hours restored. Future mandated training is on the clock."],
  },
  {
    memberKey: "james.oconnor", reference: "GR-2023-252", title: "Written warning after a documented understaffing night",
    caseType: "Discipline", step: "Closed", status: "resolved",
    articles: "Article 12 — Discipline · Article 3 — Union Rights and Representation",
    openedDaysAgo: 880, updatedDaysAgo: 800, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: [
      "Weingarten honored. Shortage log attached.",
      "Warning reduced to a coaching note and removed from the personnel file after six months.",
    ],
  },
  {
    memberKey: "yara.santos", reference: "GR-2025-430", title: "Telework days pulled without a written reason",
    caseType: "Telework", step: "Closed", status: "resolved",
    articles: "Article 15 — Telework",
    openedDaysAgo: 300, updatedDaysAgo: 240, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Days restored. The denial letter now states the operational reason in writing."],
  },
  {
    memberKey: "keisha.bennett", reference: "GR-2024-370", title: "Breaks missed on a double shift",
    caseType: "Hours", step: "Closed", status: "resolved",
    articles: "Article 7 — Hours of Work",
    openedDaysAgo: 520, updatedDaysAgo: 470, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Missed breaks paid. The house posted a relief rotation."],
  },
  {
    memberKey: "luis.ferreira", reference: "GR-2026-150", title: "Language-access delay on a service plan meeting",
    caseType: "Accommodation", step: "Step 1", status: "active",
    articles: "Article 21 — Reasonable Accommodation",
    openedDaysAgo: 28, updatedDaysAgo: 6, deadlineInDays: 14,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Interpreter request filed. The agency has not confirmed a date."],
  },
  {
    memberKey: "grace.nkrumah", reference: "GR-2026-154", title: "New-hire orientation skipped the union packet",
    caseType: "Union rights", step: "Intake", status: "active",
    articles: "Article 3 — Union Rights and Representation",
    openedDaysAgo: 11, updatedDaysAgo: 4, deadlineInDays: 20,
    stewardKey: "sam.okafor", coordinatorKey: null,
    updates: ["Intake taken. Asking the office for the last three orientation sign-in sheets."],
  },
  {
    memberKey: "daniel.shea", reference: "GR-2025-442", title: "Out-of-title medication-count duty",
    caseType: "Classification", step: "Closed", status: "resolved",
    articles: "Article 6 — Job Classification",
    openedDaysAgo: 260, updatedDaysAgo: 190, deadlineInDays: null,
    stewardKey: "sam.okafor", coordinatorKey: "jordan.patel",
    updates: ["Duty returned to the licensed role. Two weeks of out-of-title pay issued."],
  },
].map(Object.freeze));

const STEWARD_WIRE_NAME = "Chapter steward";

export const SAMPLE_HISTORY_CONVERSATIONS = Object.freeze([
  {
    memberKey: "elena.costa", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 400,
    messages: [
      { senderKind: "member", daysAgo: 400, read: true, body: "They skipped me on the weekend list again. I have the posting and the text that changed it." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 399, read: true, body: "Send both. We will file on the seniority skip and ask for make-whole." },
      { senderKind: "member", daysAgo: 398, read: true, body: "Sent. The 14th is the date they jumped me." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 360, read: true, body: "Step 2 closed it. The shift is made whole and the list is back on the board." },
    ],
  },
  {
    memberKey: "jamal.wright", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 390,
    messages: [
      { senderKind: "member", daysAgo: 390, read: true, body: "They kept asking questions after I asked for a steward. I said the Weingarten line twice." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 389, read: true, body: "You did the right thing. Write down who was in the room. I am opening a file today." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 310, read: true, body: "The warning is withdrawn. Next time they have to wait." },
    ],
  },
  {
    memberKey: "maeve.flaherty", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 990,
    messages: [
      { senderKind: "member", daysAgo: 990, read: true, body: "I am twenty-two over the written caseload standard and nobody has taken a case off." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 988, read: true, body: "Bring the assignment sheet to the office. We will compare it to the 2023 standard line by line." },
      { senderKind: "member", daysAgo: 970, read: true, body: "Two cases moved last week. Thank you." },
    ],
  },
  {
    memberKey: "yara.santos", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 295,
    messages: [
      { senderKind: "member", daysAgo: 295, read: true, body: "They pulled my telework days and would not put a reason in the letter." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 294, read: true, body: "Article 15 requires a stated reason. Ask again in writing and forward whatever they send." },
      { senderKind: "member", daysAgo: 240, read: true, body: "Days are restored. I saved the new letter." },
    ],
  },
  {
    memberKey: "luis.ferreira", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 27,
    messages: [
      { senderKind: "member", daysAgo: 27, read: true, body: "The service-plan meeting is still without an interpreter. I asked two weeks ago." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 26, read: true, body: "That is past the window. I opened Step 1. Do not attend without the interpreter." },
      { senderKind: "member", daysAgo: 6, read: false, body: "They offered a phone line. I said no. Waiting on a confirmed in-person date." },
    ],
  },
  {
    memberKey: "grace.nkrumah", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 10,
    messages: [
      { senderKind: "member", daysAgo: 10, read: true, body: "Orientation did not include the union packet. I started last Monday." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 9, read: false, body: "Welcome. I am pulling the sign-in sheets. Stop by the office and I will walk you through Weingarten the same day." },
    ],
  },
  {
    memberKey: "keisha.bennett", title: STEWARD_WIRE_NAME, initials: "CS", openedDaysAgo: 518,
    messages: [
      { senderKind: "member", daysAgo: 518, read: true, body: "I worked a double and never got a relief for either meal." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 517, read: true, body: "Log the times. We can recover the missed breaks and get a rotation on the wall." },
      { senderKind: "steward", senderName: STEWARD_WIRE_NAME, daysAgo: 470, read: true, body: "Paid. The relief rotation is posted. Tell me the first week it slips." },
    ],
  },
].map(Object.freeze));

export const SAMPLE_HISTORY_TASKS = Object.freeze([
  { title: "Archive the 2025 ratification packet", workstream: "Contract campaign", status: "done", priority: "medium", assigneeKey: "alex.rivera", startInDays: -430, dueInDays: -390, progress: 100, blocked: false, milestone: true, description: "Link the authorized record. Do not copy member names into this card." },
  { title: "Post the 2024 overtime memorandum in every break room", workstream: "Health and safety", status: "done", priority: "high", assigneeKey: "sam.okafor", startInDays: -760, dueInDays: -735, progress: 100, blocked: false, milestone: true, description: "Same one-pager at residential, day program, and the van bay." },
  { title: "Run the 2024 steward election", workstream: "Membership", status: "done", priority: "high", assigneeKey: "taylor.morgan", startInDays: -920, dueInDays: -870, progress: 100, blocked: false, milestone: true, description: "Nominations on the floor, ten-day window, results posted the night of the count." },
  { title: "Prepare lobby-day one-pagers for 2026", workstream: "Contract campaign", status: "done", priority: "medium", assigneeKey: "avery.nguyen", startInDays: -60, dueInDays: -40, progress: 100, blocked: false, milestone: false, description: "Staffing ratios and overtime cap only. No member stories on the page." },
  { title: "Call members who have not answered the overtime pulse", workstream: "Membership", status: "in_progress", priority: "medium", assigneeKey: "sam.okafor", startInDays: -3, dueInDays: 2, progress: 35, blocked: false, milestone: false, description: "Link the pulse record. Do not put answers in this card." },
  { title: "Count the steward-slate ballot at close", workstream: "Membership", status: "to_do", priority: "high", assigneeKey: "alex.rivera", startInDays: 8, dueInDays: 12, progress: 0, blocked: false, milestone: true, description: "Two counters. Post the certified result the same night." },
].map(Object.freeze));

export const SAMPLE_HISTORY_NOTIFICATIONS = Object.freeze([
  {
    key: "steward-slate-open", audience: "all", hoursAgo: 72,
    title: "Steward-slate ballot is open",
    body: "Nominations closed. Open Votes to confirm or reopen the 2026–2027 slate. It closes in eleven days.",
  },
  {
    key: "overtime-pulse", audience: "all", hoursAgo: 30,
    title: "This week's overtime pulse is up",
    body: "One question. It helps the desk see which sites are running hot before the membership meeting.",
  },
  {
    key: "bargaining-pulse", audience: "all", hoursAgo: 96,
    title: "Bargaining-priority pulse is open",
    body: "Pick the one issue you want the contract action team to lead with this fall.",
  },
].map(Object.freeze));

export const SAMPLE_SPACES = Object.freeze([
  {
    key: "steward-network",
    name: "Steward network",
    description: "Investigatory coverage, Step 1/2 traffic, and who is on call this week.",
    visibility: "staff",
    createdDaysAgo: 1000,
    threads: [
      {
        key: "coverage-aug-2026",
        title: "Investigatory coverage — August 2026",
        kind: "topic",
        status: "open",
        createdDaysAgo: 16,
        posts: [
          { authorKey: "sam.okafor", daysAgo: 16, body: "I can take Pinebend and Brooks St this week. Rosa has the residential houses on the weekend." },
          { authorKey: "jordan.patel", daysAgo: 15, body: "Coordinator desk will flag any Step 2 that lands after 4. Do not put member medical detail in this thread." },
          { authorKey: "avery.nguyen", daysAgo: 12, body: "Weingarten script copies are in the hall. If a new steward is sitting in, walk them through it before the meeting starts." },
        ],
      },
      {
        key: "step2-overtime-2026",
        title: "Step 2 packet — weekend rota",
        kind: "case",
        status: "open",
        createdDaysAgo: 8,
        posts: [
          { authorKey: "sam.okafor", daysAgo: 8, body: "Packet is ready aside from the 16th posting. Agency still has not produced that week." },
          { authorKey: "jordan.patel", daysAgo: 6, body: "I asked again in writing. If it is not here by Friday we file with the gap noted." },
        ],
      },
    ],
  },
  {
    key: "health-safety",
    name: "Health and safety",
    description: "Walkthroughs, van lifts, and incident numbers — no medical detail.",
    visibility: "chapter",
    createdDaysAgo: 980,
    threads: [
      {
        key: "walkthrough",
        title: "Day-program walkthrough list",
        kind: "issue",
        status: "open",
        createdDaysAgo: 20,
        posts: [
          { authorKey: "sam.okafor", daysAgo: 20, body: "Brooks St lift bracket is still empty. Incident number is in the binder from the 3rd." },
          { authorKey: "jordan.patel", daysAgo: 18, body: "Coordinator desk can hold 9 AM if maintenance confirms. Bring incident numbers, not stories." },
          { authorKey: "sam.okafor", daysAgo: 11, body: "Date is on the calendar. Last ninety days of incident numbers only." },
        ],
      },
      {
        key: "van-inspections-2024",
        title: "Monthly van lift inspections",
        kind: "decision",
        status: "resolved",
        createdDaysAgo: 820,
        posts: [
          { authorKey: "sam.okafor", daysAgo: 820, body: "The Pinebend van went out without a working lift twice in one month. Drivers logged both runs." },
          { authorKey: "taylor.morgan", daysAgo: 800, body: "Agency agreed to a written monthly inspection. Mark this resolved once the first log is in the binder." },
          { authorKey: "sam.okafor", daysAgo: 790, body: "First log is in. Closing this thread. New misses get their own issue." },
        ],
      },
    ],
  },
  {
    key: "contract-campaign",
    name: "Contract campaign",
    description: "Petition, worksite leaders, and what we take to the table.",
    visibility: "chapter",
    createdDaysAgo: 1060,
    threads: [
      {
        key: "petition-2026",
        title: "Weekend-rota petition — site report-backs",
        kind: "topic",
        status: "open",
        createdDaysAgo: 40,
        posts: [
          { authorKey: "darnell.foster", daysAgo: 40, body: "Residential is moving. Day program still needs Brooks St and Pinebend second shift on the sheet." },
          { authorKey: "sam.okafor", daysAgo: 28, body: "I can cover Brooks St on Thursday with the worksite leaders." },
          { authorKey: "taylor.morgan", daysAgo: 19, body: "Two hundred eleven. We are putting the endorsement ballot up. Keep collecting through the close." },
        ],
      },
      {
        key: "ratify-2025",
        title: "2025 ratification turnout",
        kind: "decision",
        status: "resolved",
        createdDaysAgo: 430,
        posts: [
          { authorKey: "alex.rivera", daysAgo: 430, body: "Ballot is open. Quorum is twenty-two. We will count the night it closes." },
          { authorKey: "taylor.morgan", daysAgo: 400, body: "Ratified. Print Article 7 and the overtime cap for the break rooms. Closing this thread." },
        ],
      },
    ],
  },
].map(Object.freeze));

export const SAMPLE_GUIDE_THREADS = Object.freeze([
  {
    memberKey: "darnell.foster",
    title: "Weekend rotation changed with no notice",
    openedDaysAgo: 16,
    messages: [
      { role: "user", daysAgo: 16, body: "They changed my weekend rotation on the 3rd and did not post it. What article do I use?" },
      { role: "assistant", daysAgo: 16, body: "Article 7 covers hours of work and posted schedules. Save both versions and message your steward the same day. A Step 1 can ask for the posting and for make-whole if you lost a preferred day." },
    ],
  },
  {
    memberKey: "darnell.foster",
    title: "Weingarten before a meeting",
    openedDaysAgo: 220,
    messages: [
      { role: "user", daysAgo: 220, body: "Supervision asked me to come in and talk about an incident. Can I bring a steward?" },
      { role: "assistant", daysAgo: 220, body: "If you reasonably believe the meeting could lead to discipline, you can ask for union representation before you answer. A clear line is: I request a steward before answering questions. The meeting should wait." },
    ],
  },
  {
    memberKey: "sam.okafor",
    title: "Step 2 deadline on the overtime file",
    openedDaysAgo: 5,
    messages: [
      { role: "user", daysAgo: 5, body: "Employer owes a Step 2 answer at the end of next week. What do I track besides the letter?" },
      { role: "assistant", daysAgo: 5, body: "Track the demand date, what you asked them to produce, and whether the answer addresses each point. If the letter is late or silent on the rota records, note the gap in the file and tell the coordinator." },
    ],
  },
].map(Object.freeze));

export const SAMPLE_KB_ARTICLES = Object.freeze([
  {
    slug: "wor-article-3-union-rights",
    kind: "contract",
    title: "Article 3 — Union Rights and Representation",
    articleRef: "Cedar Ridge Care Services · Article 3",
    orderIndex: 1,
    keywords: ["union rights", "representation", "steward", "Weingarten"],
    body: "Article 3 recognizes the chapter as the exclusive representative for covered Cedar Ridge Care Services employees. Members may join, meet with a steward, and request representation in investigatory meetings that could lead to discipline. Stewards have reasonable time to handle representation duties. If a supervisor calls a meeting, ask whether it could lead to discipline and request a steward before answering.",
  },
  {
    slug: "wor-article-5-grievance",
    kind: "contract",
    title: "Article 5 — Grievance Procedure",
    articleRef: "Cedar Ridge Care Services · Article 5",
    orderIndex: 2,
    keywords: ["grievance", "step 1", "step 2", "deadlines"],
    body: "Most disputes start with the steward and the supervisor, then move to a written Step 1 and, if needed, Step 2. Deadlines run from the day you knew or should have known of the issue, so write the date down. Your steward files and tracks the grievance with you. Do not put medical detail in a task card; link the authorized file instead.",
  },
  {
    slug: "wor-article-7-hours",
    kind: "contract",
    title: "Article 7 — Hours of Work",
    articleRef: "Cedar Ridge Care Services · Article 7",
    orderIndex: 3,
    keywords: ["hours of work", "schedule", "overtime", "weekend rota"],
    body: "Article 7 covers the posted schedule, notice for changes, breaks, and how overtime is offered. Weekend rotations and seniority lists belong on the board, not in a text message that replaces the posting. Keep both versions if a schedule changes. Raise a same-day skip with your steward.",
  },
  {
    slug: "wor-article-8-overtime",
    kind: "contract",
    title: "Article 8 — Overtime",
    articleRef: "Cedar Ridge Care Services · Article 8",
    orderIndex: 4,
    keywords: ["overtime", "mandate", "seniority", "cap"],
    body: "Overtime is offered in seniority order on the posted list. The 2024 memorandum caps consecutive mandated shifts. If you are skipped or mandated past the cap, write the date, keep the posting, and tell your steward the same day.",
  },
  {
    slug: "wor-article-12-discipline",
    kind: "contract",
    title: "Article 12 — Discipline",
    articleRef: "Cedar Ridge Care Services · Article 12",
    orderIndex: 5,
    keywords: ["discipline", "just cause", "warning", "investigatory meeting"],
    body: "Discipline requires just cause and generally moves in steps. You have the right to know the reason and to union representation. Do not sign that you agree — receipt is not agreement. Contact your steward before an investigatory meeting.",
  },
  {
    slug: "wor-article-16-safety",
    kind: "contract",
    title: "Article 16 — Health and Safety",
    articleRef: "Cedar Ridge Care Services · Article 16",
    orderIndex: 6,
    keywords: ["health and safety", "lift", "van", "incident"],
    body: "Report hazards in writing, preserve incident numbers, and use the joint walkthrough when a site repeats a miss. Lift equipment and van logs are chapter business. You can refuse an unsafe run and still document it. Medical detail stays out of the thread.",
  },
  {
    slug: "wor-faq-weingarten",
    kind: "faq",
    title: "What is Weingarten and when do I use it?",
    articleRef: "Cedar Ridge Care Services · Rights",
    orderIndex: 7,
    keywords: ["weingarten", "steward", "investigatory meeting"],
    body: "If a meeting could lead to discipline, you may ask for a steward before you answer. Say you request union representation. The meeting should pause until a steward is there. If it continues, repeat the request, take notes, and write your steward the same day.",
  },
  {
    slug: "wor-faq-file-grievance",
    kind: "faq",
    title: "How do I file a grievance?",
    articleRef: "Cedar Ridge Care Services · Rights",
    orderIndex: 8,
    keywords: ["file a grievance", "steward", "step 1"],
    body: "Start with your steward. Bring dates, postings, and names. Many issues resolve informally. If not, the steward helps file Step 1. Deadlines are short. Do not paste another member's information into a task title; link the authorized record.",
  },
].map(Object.freeze));

// Partner labor organizations for chapter handshakes. SAMPLE has no Atlas
// import, so the handshake picker is empty unless this catalog is written.
// These rows are a Tamarack higher-order cluster plus a few Massachusetts
// coalition partners. They live only in the SAMPLE project; production
// union_orgs stays an Atlas load, never this list.
export const SAMPLE_PARTNER_OLMS_LOCAL = 900509001;
export const SAMPLE_PARTNER_ATLAS_SHA = "fictional-campaign-network-v1";

export const SAMPLE_PARTNER_ORGS = Object.freeze([
  {
    id: "ug-tamarack-psu",
    olmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    name: "Tamarack Public Service Union",
    affiliation: "Tamarack",
    designation: "Local",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: 900000509,
    parentAffiliation: "Tamarack",
    parentName: "Service Employees International Union",
    city: "Pine Harbor",
    state: "MA",
    zip: "02108",
    membersLatest: 18420,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-bos-dds",
    olmsFileNumber: 900509101,
    name: "Pine Harbor Care Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Pine Harbor",
    state: "MA",
    zip: "02111",
    membersLatest: 410,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-spr-dds",
    olmsFileNumber: 900509102,
    name: "Maple Crossing Care Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Maple Crossing",
    state: "MA",
    zip: "01103",
    membersLatest: 280,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-law-dds",
    olmsFileNumber: 900509103,
    name: "Willow Bend Care Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Willow Bend",
    state: "MA",
    zip: "01840",
    membersLatest: 190,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-nbd-dds",
    olmsFileNumber: 900509104,
    name: "Hemlock Bay Care Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Hemlock Bay",
    state: "MA",
    zip: "02740",
    membersLatest: 165,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-wor-dcf",
    olmsFileNumber: 900509201,
    name: "Cedar Ridge Family Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Cedar Ridge",
    state: "MA",
    zip: "01608",
    membersLatest: 220,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-bos-dta",
    olmsFileNumber: 900509301,
    name: "Pine Harbor Benefits Office Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Pine Harbor",
    state: "MA",
    zip: "02114",
    membersLatest: 310,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-hyn-dds",
    olmsFileNumber: 900509105,
    name: "Spruce Point Care Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Spruce Point",
    state: "MA",
    zip: "02601",
    membersLatest: 95,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-pit-dds",
    olmsFileNumber: 900509106,
    name: "Birch Hollow Care Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Birch Hollow",
    state: "MA",
    zip: "01201",
    membersLatest: 80,
    membersLatestYear: 2025,
  },
  {
    id: "ug-509-wor-mrc",
    olmsFileNumber: 900509401,
    name: "Cedar Ridge Rehab Services Chapter",
    affiliation: "Tamarack",
    designation: "Chapter",
    localNumber: "509",
    level: "local",
    parentOlmsFileNumber: SAMPLE_PARTNER_OLMS_LOCAL,
    parentAffiliation: "Tamarack",
    parentName: "Tamarack Public Service Union",
    city: "Cedar Ridge",
    state: "MA",
    zip: "01608",
    membersLatest: 70,
    membersLatestYear: 2025,
  },
  {
    id: "ug-tamarack-alliance",
    olmsFileNumber: 900093001,
    name: "Tamarack Public Services Alliance",
    affiliation: "Tamarack Alliance",
    designation: "Council",
    localNumber: "93",
    level: "intermediate",
    parentOlmsFileNumber: 900000093,
    parentAffiliation: "Tamarack Alliance",
    parentName: "American Federation of State, County and Municipal Employees",
    city: "Pine Harbor",
    state: "MA",
    zip: "02108",
    membersLatest: 42000,
    membersLatestYear: 2025,
  },
  {
    id: "ug-mta",
    olmsFileNumber: 900054001,
    name: "Pinebend Educators Association",
    affiliation: "Pinebend Education Network",
    designation: "State affiliate",
    localNumber: null,
    level: "intermediate",
    parentOlmsFileNumber: 900000054,
    parentAffiliation: "Pinebend Education Network",
    parentName: "National Education Association",
    city: "Pine Harbor",
    state: "MA",
    zip: "02108",
    membersLatest: 117000,
    membersLatestYear: 2025,
  },
  {
    id: "ug-mna",
    olmsFileNumber: 900011001,
    name: "Juniper Nurses Alliance",
    affiliation: "Independent",
    designation: "State association",
    localNumber: null,
    level: "local",
    parentOlmsFileNumber: null,
    parentAffiliation: null,
    parentName: null,
    city: "Aspen Vale",
    state: "MA",
    zip: "02021",
    membersLatest: 23000,
    membersLatestYear: 2025,
  },
].map(Object.freeze));

export const SAMPLE_HANDSHAKES = Object.freeze([
  {
    partnerOrgId: "ug-tamarack-psu",
    title: "Statewide steward training library",
    purpose: "Share steward scripts, Weingarten cards, and investigatory checklists across Tamarack chapters. No member files.",
    dataScope: "docs_only",
    status: "active",
    requestedDaysAgo: 1020,
    countersignedDaysAgo: 1005,
  },
  {
    partnerOrgId: "ug-509-bos-dds",
    title: "Caseload comparison with Pine Harbor Care Services",
    purpose: "Exchange aggregate overtime and vacancy counts so both desks can see whether the weekend rota problem is local or statewide.",
    dataScope: "aggregate_only",
    status: "active",
    requestedDaysAgo: 410,
    countersignedDaysAgo: 398,
  },
  {
    partnerOrgId: "ug-509-spr-dds",
    title: "Van-lift inspection packet",
    purpose: "Maple Crossing's monthly van-lift log is the template Cedar Ridge adopted after the Pinebend misses. Documents only.",
    dataScope: "docs_only",
    status: "active",
    requestedDaysAgo: 820,
    countersignedDaysAgo: 805,
  },
  {
    partnerOrgId: "ug-509-law-dds",
    title: "Overtime rota posting template",
    purpose: "Willow Bend asked to use Cedar Ridge's weekend-rota posting form. No names travel with the form.",
    dataScope: "docs_only",
    status: "requested",
    requestedDaysAgo: 12,
    countersignedDaysAgo: null,
  },
  {
    partnerOrgId: "ug-tamarack-alliance",
    title: "Lobby-day coalition packet",
    purpose: "Joint one-pagers for the Beacon Hill staffing-ratio day. No member stories and no worksite lists.",
    dataScope: "no_member_data",
    status: "active",
    requestedDaysAgo: 620,
    countersignedDaysAgo: 605,
  },
  {
    partnerOrgId: "ug-509-nbd-dds",
    title: "Ratification observer protocol",
    purpose: "Hemlock Bay sent two observers to the 2025 count. Packet is closed. No ballots left the room.",
    dataScope: "docs_only",
    status: "closed",
    requestedDaysAgo: 450,
    countersignedDaysAgo: 430,
  },
  {
    partnerOrgId: "ug-509-wor-dcf",
    title: "Joint health-and-safety walkthrough",
    purpose: "Cedar Ridge Family Services and Cedar Ridge Care Services share a building. Walkthrough notes cover lifts, exits, and incident numbers only.",
    dataScope: "docs_only",
    status: "accepted",
    requestedDaysAgo: 48,
    countersignedDaysAgo: 40,
  },
  {
    partnerOrgId: "ug-mna",
    title: "Contract language on mandatory overtime",
    purpose: "Asked MNA whether their overtime-cap language could inform the DDS table. They declined a document share.",
    dataScope: "docs_only",
    status: "declined",
    requestedDaysAgo: 780,
    countersignedDaysAgo: null,
  },
  {
    partnerOrgId: "ug-tamarack-psu",
    title: "2023 convention credential packet",
    purpose: "Tamarack issued chapter credentials for the 2023 convention. Closed after the delegation returned.",
    dataScope: "docs_only",
    status: "closed",
    requestedDaysAgo: 1080,
    countersignedDaysAgo: 1070,
  },
  {
    partnerOrgId: "ug-509-hyn-dds",
    title: "Cape weekend coverage notes",
    purpose: "Cedar Ridge sent Spruce Point the Friday-to-Monday coverage sheet. Documents only. No names. Waiting on countersign.",
    dataScope: "docs_only",
    status: "requested",
    requestedDaysAgo: 1,
    countersignedDaysAgo: null,
  },
  {
    partnerOrgId: "ug-509-pit-dds",
    title: "Berkshire vacancy tally",
    purpose: "Cedar Ridge sent this month's aggregate vacancy count so Birch Hollow can see whether the western rota hole is local.",
    dataScope: "aggregate_only",
    status: "requested",
    requestedDaysAgo: 3,
    countersignedDaysAgo: null,
  },
  {
    partnerOrgId: "ug-mta",
    title: "Educator coalition staffing one-pager",
    purpose: "Cedar Ridge sent a no-names staffing-ratio sheet ahead of the September public-services day. Waiting on Pinebend Educators Association.",
    dataScope: "no_member_data",
    status: "requested",
    requestedDaysAgo: 4,
    countersignedDaysAgo: null,
  },
  {
    partnerOrgId: "ug-509-bos-dta",
    title: "SNAP recertification walkthrough",
    purpose: "Cedar Ridge asked Pine Harbor Benefits Office for their document-only recertification walkthrough. Not countersigned yet.",
    dataScope: "docs_only",
    status: "requested",
    requestedDaysAgo: 6,
    countersignedDaysAgo: null,
  },
  {
    partnerOrgId: "ug-509-wor-mrc",
    title: "Lakeside Rehab Services referral sheet",
    purpose: "Draft of the vocational-referral form Cedar Ridge Care Services and Lakeside Rehab Services would share. Documents only. Not sent yet.",
    dataScope: "docs_only",
    status: "draft",
    requestedDaysAgo: null,
    countersignedDaysAgo: null,
  },
].map(Object.freeze));

export const SAMPLE_CHAPTER_DOCUMENTS = Object.freeze([
  {
    title: "Steward Weingarten card — Cedar Ridge Care Services",
    documentType: "training",
    summary: "The card stewards carry into investigatory meetings.",
    body: "If a meeting could lead to discipline, the member may request a steward before answering. Pause the meeting until representation is arranged. Do not put another member's medical detail on this card.",
    visibility: "chapter",
    status: "published",
    publishedDaysAgo: 900,
  },
  {
    title: "Weekend rota posting template",
    documentType: "template",
    summary: "The posting form used after the 2025 ratification.",
    body: "Post the rota in the break room and the hall. List dates, shifts, and worksites. Do not list medical restrictions or member home addresses.",
    visibility: "staff",
    status: "published",
    publishedDaysAgo: 400,
  },
  {
    title: "August 2026 membership minutes",
    documentType: "minutes",
    summary: "Steward slate nominated. Overtime pulse opened.",
    body: "Membership nominated the 2026–2027 steward slate. The overtime pulse is open through the next meeting. Lobby-day one-pagers stay staffing ratios and the overtime cap only.",
    visibility: "chapter",
    status: "published",
    publishedDaysAgo: 16,
  },
].map(Object.freeze));

export const SAMPLE_CHAPTER_RECORDS = Object.freeze([
  {
    recordType: "decision",
    title: "Adopt monthly van-lift logs",
    body: "After the Pinebend misses, the chapter adopted Maple Crossing's written monthly inspection. New misses get their own issue thread.",
    occurredDaysAgo: 790,
  },
  {
    recordType: "milestone",
    title: "2025 contract ratified",
    body: "Membership ratified. Article 7 and the overtime cap go to the break rooms. Quorum was met.",
    occurredDaysAgo: 400,
  },
  {
    recordType: "management_contact",
    title: "Labor-management on Brooks St lift",
    body: "Coordinator desk held 9 AM with maintenance. Incident numbers only. Date is on the calendar.",
    occurredDaysAgo: 18,
  },
].map(Object.freeze));

// Members of sibling Tamarack chapters. They are NOT on the Cedar Ridge
// roster, so they never vote Cedar Ridge ballots or appear on Cedar Ridge desks.
// They exist so Admin organization structure and the higher-order chapter
// list read as a working local instead of one populated chapter and 28 empty
// ones. No passwords.
export const SAMPLE_PARTNER_CHAPTER_MEMBERS = Object.freeze([
  { key: "helen.park", firstName: "Helen", fullName: "Helen Park", initials: "HP", roleLine: "Case manager · Pine Harbor Care Services", memberSince: 2016, chapterId: "bos" },
  { key: "omar.hassan", firstName: "Omar", fullName: "Omar Hassan", initials: "OH", roleLine: "Direct support professional · Pine Harbor Care Services", memberSince: 2020, chapterId: "bos" },
  { key: "caitlin.burke", firstName: "Caitlin", fullName: "Caitlin Burke", initials: "CB", roleLine: "Residential counselor · Pine Harbor Care Services", memberSince: 2014, chapterId: "bos" },
  { key: "raj.mehta", firstName: "Raj", fullName: "Raj Mehta", initials: "RM", roleLine: "Day program instructor · Pine Harbor Care Services", memberSince: 2019, chapterId: "bos" },
  { key: "marisol.vega", firstName: "Marisol", fullName: "Marisol Vega", initials: "MV", roleLine: "Vocational specialist · Maple Crossing Care Services", memberSince: 2017, chapterId: "spr" },
  { key: "sean.fitzgerald", firstName: "Sean", fullName: "Sean Fitzgerald", initials: "SF", roleLine: "Maintenance technician · Maple Crossing Care Services", memberSince: 2011, chapterId: "spr" },
  { key: "aisha.mensah", firstName: "Aisha", fullName: "Aisha Mensah", initials: "AM", roleLine: "Direct support professional · Maple Crossing Care Services", memberSince: 2022, chapterId: "spr" },
  { key: "colin.murphy", firstName: "Colin", fullName: "Colin Murphy", initials: "CMU", roleLine: "Residential counselor · Maple Crossing Care Services", memberSince: 2015, chapterId: "spr" },
  { key: "leila.khoury", firstName: "Leila", fullName: "Leila Khoury", initials: "LK", roleLine: "Case manager · Willow Bend Care Services", memberSince: 2018, chapterId: "law" },
  { key: "jose.almeida", firstName: "Jose", fullName: "Jose Almeida", initials: "JA", roleLine: "Direct support professional · Willow Bend Care Services", memberSince: 2021, chapterId: "law" },
  { key: "nora.sullivan", firstName: "Nora", fullName: "Nora Sullivan", initials: "NS", roleLine: "Day program instructor · Willow Bend Care Services", memberSince: 2013, chapterId: "law" },
  { key: "paulo.costa", firstName: "Paulo", fullName: "Paulo Costa", initials: "PC", roleLine: "Transportation driver · Hemlock Bay Care Services", memberSince: 2012, chapterId: "nbd" },
  { key: "tanya.brooks", firstName: "Tanya", fullName: "Tanya Brooks", initials: "TB", roleLine: "Residential counselor · Hemlock Bay Care Services", memberSince: 2019, chapterId: "nbd" },
  { key: "erik.larsen", firstName: "Erik", fullName: "Erik Larsen", initials: "EL", roleLine: "Direct support professional · Hemlock Bay Care Services", memberSince: 2023, chapterId: "nbd" },
  { key: "maya.chen", firstName: "Maya", fullName: "Maya Chen", initials: "MC", roleLine: "Case manager · Spruce Point Care Services", memberSince: 2016, chapterId: "dds-hyn" },
  { key: "robert.pina", firstName: "Robert", fullName: "Robert Pina", initials: "RPI", roleLine: "Residential counselor · Spruce Point Care Services", memberSince: 2014, chapterId: "dds-hyn" },
  { key: "gina.romano", firstName: "Gina", fullName: "Gina Romano", initials: "GR", roleLine: "Day program instructor · Birch Hollow Care Services", memberSince: 2010, chapterId: "dds-pit" },
  { key: "kwame.asante", firstName: "Kwame", fullName: "Kwame Asante", initials: "KA", roleLine: "Direct support professional · Birch Hollow Care Services", memberSince: 2020, chapterId: "dds-pit" },
  { key: "sasha.petrov", firstName: "Sasha", fullName: "Sasha Petrov", initials: "SP", roleLine: "Social worker · Cedar Ridge Family Services", memberSince: 2015, chapterId: "dcf-wor" },
  { key: "amelia.grant", firstName: "Amelia", fullName: "Amelia Grant", initials: "AG", roleLine: "Ongoing worker · Cedar Ridge Family Services", memberSince: 2018, chapterId: "dcf-wor" },
  { key: "victor.nguyen", firstName: "Victor", fullName: "Victor Nguyen", initials: "VN", roleLine: "Investigator · Pine Harbor Family Services", memberSince: 2013, chapterId: "dcf-bos" },
  { key: "iris.coleman", firstName: "Iris", fullName: "Iris Coleman", initials: "IC", roleLine: "Case manager · Cedar Ridge Benefits Office", memberSince: 2017, chapterId: "dta-wor" },
  { key: "ben.okonkwo", firstName: "Ben", fullName: "Ben Okonkwo", initials: "BO", roleLine: "Employment counselor · Pine Harbor Benefits Office", memberSince: 2019, chapterId: "dta-bos" },
  { key: "clara.medeiros", firstName: "Clara", fullName: "Clara Medeiros", initials: "CME", roleLine: "Mental health worker · Cedar Ridge Health Services", memberSince: 2016, chapterId: "dmh-wor" },
  { key: "theo.barnes", firstName: "Theo", fullName: "Theo Barnes", initials: "THB", roleLine: "Inpatient counselor · Pine Harbor Health Services", memberSince: 2011, chapterId: "dmh-bos" },
  { key: "nina.vogel", firstName: "Nina", fullName: "Nina Vogel", initials: "NV", roleLine: "Vocational rehab counselor · Cedar Ridge Rehab Services", memberSince: 2014, chapterId: "mrc-wor" },
  { key: "peter.quinn", firstName: "Peter", fullName: "Peter Quinn", initials: "PQ", roleLine: "Youth worker · Cedar Ridge Youth Services", memberSince: 2018, chapterId: "dys-wor" },
  { key: "hana.ibrahim", firstName: "Hana", fullName: "Hana Ibrahim", initials: "HI2", roleLine: "Public health nurse · Pine Harbor Public Health", memberSince: 2012, chapterId: "dph-bos" },
].map((member) => Object.freeze({
  ...member,
  email: `${member.key}@demo.example.com`,
  roles: Object.freeze([]),
  signIn: false,
})));

export const WORKLOAD_PERSONA_KEYS = Object.freeze([
  "darnell.foster", "sam.okafor", "jordan.patel", "avery.nguyen", "kathleen.whelan", "maeve.flaherty", "yara.santos", "nadia.haddad",
]);

export function personaKeysFrom(roster) {
  return roster.filter((member) => member.signIn).map((member) => member.key);
}

export function livedInPlanSlice() {
  return {
    historyYears: SAMPLE_HISTORY_YEARS,
    extraMembers: EXTRA_CHAPTER_MEMBERS.length,
    ballots: SAMPLE_BALLOTS,
    surveys: SAMPLE_SURVEYS,
    historyEvents: SAMPLE_HISTORY_EVENTS,
    historyBroadcasts: SAMPLE_HISTORY_BROADCASTS,
    historyCases: SAMPLE_HISTORY_CASES,
    historyConversations: SAMPLE_HISTORY_CONVERSATIONS,
    historyTasks: SAMPLE_HISTORY_TASKS,
    historyNotifications: SAMPLE_HISTORY_NOTIFICATIONS,
    spaces: SAMPLE_SPACES,
    guideThreads: SAMPLE_GUIDE_THREADS,
    kbArticles: SAMPLE_KB_ARTICLES,
    partnerOrgs: SAMPLE_PARTNER_ORGS,
    handshakes: SAMPLE_HANDSHAKES,
    partnerChapterMembers: SAMPLE_PARTNER_CHAPTER_MEMBERS,
    chapterDocuments: SAMPLE_CHAPTER_DOCUMENTS,
    chapterRecords: SAMPLE_CHAPTER_RECORDS,
    placeholderBallotIds: PLACEHOLDER_BALLOT_IDS,
    placeholderSurveyIds: PLACEHOLDER_SURVEY_IDS,
    placeholderEventIds: PLACEHOLDER_EVENT_IDS,
    placeholderKbSlugs: PLACEHOLDER_KB_SLUGS,
    counts: {
      extraMembers: EXTRA_CHAPTER_MEMBERS.length,
      ballots: SAMPLE_BALLOTS.length,
      openBallots: SAMPLE_BALLOTS.filter((item) => !item.closed).length,
      closedBallots: SAMPLE_BALLOTS.filter((item) => item.closed).length,
      surveys: SAMPLE_SURVEYS.length,
      openSurveys: SAMPLE_SURVEYS.filter((item) => !item.closed).length,
      historyEvents: SAMPLE_HISTORY_EVENTS.length,
      historyBroadcasts: SAMPLE_HISTORY_BROADCASTS.length,
      historyCases: SAMPLE_HISTORY_CASES.length,
      historyConversations: SAMPLE_HISTORY_CONVERSATIONS.length,
      historyMessages: SAMPLE_HISTORY_CONVERSATIONS.reduce((total, thread) => total + thread.messages.length, 0),
      historyTasks: SAMPLE_HISTORY_TASKS.length,
      spaces: SAMPLE_SPACES.length,
      threads: SAMPLE_SPACES.reduce((total, space) => total + space.threads.length, 0),
      posts: SAMPLE_SPACES.reduce((total, space) => total + space.threads.reduce((sum, thread) => sum + thread.posts.length, 0), 0),
      guideThreads: SAMPLE_GUIDE_THREADS.length,
      kbArticles: SAMPLE_KB_ARTICLES.length,
      partnerOrgs: SAMPLE_PARTNER_ORGS.length,
      handshakes: SAMPLE_HANDSHAKES.length,
      sentHandshakes: SAMPLE_HANDSHAKES.filter((item) => item.status === "requested").length,
      draftHandshakes: SAMPLE_HANDSHAKES.filter((item) => item.status === "draft").length,
      partnerChapterMembers: SAMPLE_PARTNER_CHAPTER_MEMBERS.length,
      partnerChapters: [...new Set(SAMPLE_PARTNER_CHAPTER_MEMBERS.map((member) => member.chapterId))].length,
      chapterDocuments: SAMPLE_CHAPTER_DOCUMENTS.length,
      chapterRecords: SAMPLE_CHAPTER_RECORDS.length,
    },
  };
}
