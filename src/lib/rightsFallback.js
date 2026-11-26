// Default organizing-rights walkthrough when a chapter has no lesson row.
//
// A Weingarten fallback suits an existing bargaining unit, but
// Union Ground's workers often have no union representative yet. The
// default is NLRA Section 7 concerted activity: talking with coworkers,
// wearing a button, and refusing captive interrogation without counsel.
// This is a script, not legal advice.
export const RIGHTS_FALLBACK = {
  id: "section-7",
  label: "Section 7",
  title: "You can talk about forming a union",
  description: "Use this if a supervisor asks who is organizing, what was said at a meeting, or whether you signed a card.",
  steps: [
    "You and your coworkers may talk about pay, safety, and forming a union on non-work time.",
    "A supervisor cannot legally spy, threaten, promise favors, or interrogate you about organizing.",
    "You do not have to answer who is involved, who signed, or what was said at a meeting.",
    "Write down what was asked, who was present, and the time. Tell a committee member or organizer.",
  ],
  script: "I am not going to discuss organizing activity. If this conversation could affect my job, I want a coworker present and I will get back to you.",
};
