// The disciplinary-meeting walkthrough copy the member loader can fall back to
// when the rights-lessons table has no row for it.
//
// Before a union is recognized, most
// private-sector workers have no legal right to a representative in an
// investigatory meeting (the NLRB's 2004 IBM Corp. decision limits Weingarten
// rights to unionized workplaces, and public-sector rules vary by state). So
// this copy asks for a coworker, says the employer may refuse, and promises
// no right the worker may not have. The steps match the Disciplinary meeting
// checklist in src/features/memberSupport/contract.js and the web desk.
//
// This lives apart from fallback.js on purpose. memberApi reads these four
// fields on the ordinary signed-in path — not behind a demo gate — so importing
// them from the demo fixture module pinned all ~490 lines of seeded people,
// cases, ballots and staff desks into the member bundle where nothing could
// tree-shake them away. Four strings belong in four strings.
//
// BILINGUAL, because of what these four strings ARE. Everything else that falls
// back to English is a label a member can work around; this is the sentence a
// member says out loud, to their manager, in a meeting that can end their job.
// The bilingual design pass filed it first for that reason: a Spanish-speaking
// member reaching this path got a script they could not read from, at the exact
// moment they had least room to improvise.
//
// It is a FALLBACK — the rights-lessons table supplies the real copy, and that
// copy is already per-locale. This is what shows when the table has no row, and
// "no row" is not a state that should change which language the product speaks.
const FALLBACK = {
  en: {
    title: "Surprise disciplinary meeting",
    description: "Use this if management pulls you into a meeting that could lead to discipline.",
    steps: [
      "Ask whether the meeting could lead to discipline.",
      "Ask for a coworker to be present. The employer may say no, but asking is still worth it.",
      "Stay calm. Don't guess or speculate, don't sign anything you disagree with, and ask for a copy of anything you are given or asked to sign.",
      "Right after, write down the time, place, people, and documents, and tell a committee member or organizer.",
    ],
    script: "Could this meeting lead to discipline? If it could, I would like a coworker to be present. I will not sign anything I disagree with, and I would like a copy of anything you give me or ask me to sign.",
  },
  es: {
    title: "Reunión disciplinaria sorpresa",
    description: "Úsalo si la gerencia te lleva a una reunión que podría terminar en una acción disciplinaria.",
    steps: [
      "Pregunta si la reunión podría llevar a una medida disciplinaria.",
      "Pide que esté presente un compañero o compañera de trabajo. El empleador puede negarse, pero vale la pena pedirlo.",
      "Mantén la calma. No adivines ni especules, no firmes nada con lo que no estés de acuerdo y pide una copia de todo lo que te entreguen o te pidan firmar.",
      "Justo después, anota la hora, el lugar, las personas y los documentos, y cuéntaselo a un miembro del comité o a un organizador.",
    ],
    script: "¿Esta reunión podría llevar a una medida disciplinaria? Si es así, quisiera que un compañero o compañera de trabajo esté presente. No voy a firmar nada con lo que no esté de acuerdo, y quisiera una copia de todo lo que me entreguen o me pidan firmar.",
  },
};

/**
 * The disciplinary-meeting fallback in the member's language.
 *
 * A function rather than an exported map so the call site cannot pick a locale
 * by indexing and silently get `undefined` for one it does not have — the shape
 * of bug that turns a missing translation into a blank screen instead of an
 * English one.
 */
export function rightsLessonFallback(lang) {
  return FALLBACK[lang] || FALLBACK.en;
}

// The English shape, kept as a named export because the demo fixture composes
// it (src/data/fallback.js) and the demo is English-only by construction.
export const RIGHTS_LESSON_FALLBACK = FALLBACK.en;
