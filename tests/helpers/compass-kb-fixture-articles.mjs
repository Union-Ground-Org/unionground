// Eight classified knowledge-article bodies the Guide's DB proofs index on both
// document paths (tests/compass-document-classification-db.test.js and
// tests/compass-scope-resolver-db.test.js). They were Union Ground's SAMPLE
// knowledge rows (scripts/sample-lived-in-history.mjs), which Union Ground
// does not carry; only these proofs use them, so they live with the proofs.
// The texts are contract-shaped on purpose: the classifier must keep ordinary
// agreement language usable. References name a fictional agreement.
export const SAMPLE_KB_ARTICLES = Object.freeze([
  {
    slug: "kb-article-3-union-rights",
    kind: "contract",
    title: "Article 3 — Union Rights and Representation",
    articleRef: "Example agreement · Article 3",
    orderIndex: 1,
    keywords: ["union rights", "representation", "steward", "Weingarten"],
    body: "Article 3 recognizes the chapter as the exclusive representative for covered employees. Members may join, meet with a steward, and request representation in investigatory meetings that could lead to discipline. Stewards have reasonable time to handle representation duties. If a supervisor calls a meeting, ask whether it could lead to discipline and request a steward before answering.",
  },
  {
    slug: "kb-article-5-grievance",
    kind: "contract",
    title: "Article 5 — Grievance Procedure",
    articleRef: "Example agreement · Article 5",
    orderIndex: 2,
    keywords: ["grievance", "step 1", "step 2", "deadlines"],
    body: "Most disputes start with the steward and the supervisor, then move to a written Step 1 and, if needed, Step 2. Deadlines run from the day you knew or should have known of the issue, so write the date down. Your steward files and tracks the grievance with you. Do not put medical detail in a task card; link the authorized file instead.",
  },
  {
    slug: "kb-article-7-hours",
    kind: "contract",
    title: "Article 7 — Hours of Work",
    articleRef: "Example agreement · Article 7",
    orderIndex: 3,
    keywords: ["hours of work", "schedule", "overtime", "weekend rota"],
    body: "Article 7 covers the posted schedule, notice for changes, breaks, and how overtime is offered. Weekend rotations and seniority lists belong on the board, not in a text message that replaces the posting. Keep both versions if a schedule changes. Raise a same-day skip with your steward.",
  },
  {
    slug: "kb-article-8-overtime",
    kind: "contract",
    title: "Article 8 — Overtime",
    articleRef: "Example agreement · Article 8",
    orderIndex: 4,
    keywords: ["overtime", "mandate", "seniority", "cap"],
    body: "Overtime is offered in seniority order on the posted list. The 2024 memorandum caps consecutive mandated shifts. If you are skipped or mandated past the cap, write the date, keep the posting, and tell your steward the same day.",
  },
  {
    slug: "kb-article-12-discipline",
    kind: "contract",
    title: "Article 12 — Discipline",
    articleRef: "Example agreement · Article 12",
    orderIndex: 5,
    keywords: ["discipline", "just cause", "warning", "investigatory meeting"],
    body: "Discipline requires just cause and generally moves in steps. You have the right to know the reason and to union representation. Do not sign that you agree — receipt is not agreement. Contact your steward before an investigatory meeting.",
  },
  {
    slug: "kb-article-16-safety",
    kind: "contract",
    title: "Article 16 — Health and Safety",
    articleRef: "Example agreement · Article 16",
    orderIndex: 6,
    keywords: ["health and safety", "lift", "van", "incident"],
    body: "Report hazards in writing, preserve incident numbers, and use the joint walkthrough when a site repeats a miss. Lift equipment and van logs are chapter business. You can refuse an unsafe run and still document it. Medical detail stays out of the thread.",
  },
  {
    slug: "kb-faq-weingarten",
    kind: "faq",
    title: "What is Weingarten and when do I use it?",
    articleRef: "Example agreement · Rights",
    orderIndex: 7,
    keywords: ["weingarten", "steward", "investigatory meeting"],
    body: "If a meeting could lead to discipline, you may ask for a steward before you answer. Say you request union representation. The meeting should pause until a steward is there. If it continues, repeat the request, take notes, and write your steward the same day.",
  },
  {
    slug: "kb-faq-file-grievance",
    kind: "faq",
    title: "How do I file a grievance?",
    articleRef: "Example agreement · Rights",
    orderIndex: 8,
    keywords: ["file a grievance", "steward", "step 1"],
    body: "Start with your steward. Bring dates, postings, and names. Many issues resolve informally. If not, the steward helps file Step 1. Deadlines are short. Do not paste another member's information into a task title; link the authorized record.",
  },
].map(Object.freeze));
