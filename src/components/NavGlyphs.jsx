// Quiet single-weight line icons for the mobile card layer (owner Rev 2
// sign-off, 2026-08-08, from the ChatGPT/Claude sidebar reference): they
// replace the emoji column on the left card's function rows. Keyed by the
// nav item key from mobileNav.js; unfamiliar keys use the same neutral line
// glyph instead of falling back to a platform-dependent emoji.
// Stroke geometry lives here; size/stroke styling lives on .nav-glyph.

const GLYPH_PATHS = {
  today: <path d="M3.2 11.2 12 3.6l8.8 7.6M5.8 9.8V20h12.4V9.8M10 20v-5.4h4V20" />,
  messages: <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />,
  voting: <path d="M4 10h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm5 0 2-6h2l2 6M12 13v3" />,
  rewards: <path d="m12 3 2.7 5.6 6.3.8-4.6 4.3 1.2 6.1L12 16.9 6.4 19.8l1.2-6.1L3 9.4l6.3-.8z" />,
  cases: <path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 8l2-4h12l2 4M10 12h4" />,
  forms: <path d="M12 20h8M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4z" />,
  workload: <path d="M12 21a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-12v4l3 2M9 2h6" />,
  numbers: <path d="M4 20V4M4 20h16M8 16v-6M13 16V7M18 16v-4" />,
  appointments: <path d="M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M4 10h16" />,
  compass: <path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zm3-12-2 4-4 2 2-4z" />,
  // Dues is a receipt and the membership card an ID card, so the two never
  // share the neutral fallback glyph
  // (UX-UG-WEB-NAVIGATION-TOO-MANY-DESTINATIONS-20261018).
  dues: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />,
  card: <path d="M3 6h18v12H3zM8.5 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM6 15.5h5M13 10h5M13 13h4" />,
  rights: <path d="M12 3v18M4 21h16M7 6l-4 7h8zM17 6l-4 7h8zM7 6h10" />,
  hub: <path d="m4 11 8-7 8 7M6 9.5V20h12V9.5" />,
  network: <path d="M12 7.4a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM5.5 20.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM18.5 20.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM11 7.2 6.5 16.3M13 7.2l4.5 9.1M7.7 18.3h8.6" />,
  voice: <path d="M4 10v4h3l6 4V6l-6 4zM16 9a5 5 0 0 1 0 6M18.5 6.5a8.5 8.5 0 0 1 0 11" />,
  events: <path d="M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M4 10h16M12 13v4M10 15h4" />,
  campaigns: <path d="M4 9h16M6 9V6h12v3M6 9v10h12V9M9 13h6M9 16h4" />,
  search: <path d="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm9 2-3.5-3.5" />,
  notifications: <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 19a2 2 0 0 0 4 0" />,
  profile: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 5-6 8-6s6.5 2 8 6" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0-13v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />,
  // From the promo package's kit/brand/theme/icons.json ("pulse" and
  // "chapters"), copied exactly: Pulse and Find my steward fell back to the
  // default glyph and shared it (#9565 B-36).
  pulse: <path d="M3.4 12.4h3.7l2.3-6.2 4.3 12 2.4-5.8h4.5" />,
  "find-steward": <><circle cx="9" cy="8.6" r="3.2" /><path d="M3.4 19.6c.4-3.3 2.6-5.3 5.6-5.3s5.2 2 5.6 5.3" /><path d="M15.4 5.7a3.2 3.2 0 0 1 0 5.9M17.2 14.6c1.9.7 3.1 2.4 3.4 5" /></>,
  default: <path d="M5 5h14v14H5zM8 9h8M8 13h8M8 17h5" />,
};

const GLYPH_ALIASES = {
  tasks: "forms",
  "events-desk": "events",
  steward: "cases",
  "steward-caseload": "rights",
  "steward-requests": "messages",
  "steward-appointments": "appointments",
  "steward-forms": "forms",
  "steward-messages": "messages",
  "steward-checkins": "voting",
  "steward-broadcasts": "voice",
  coordinator: "forms",
  "coordinator-cases": "cases",
  "coordinator-deadlines": "appointments",
  "coordinator-funnel": "numbers",
  "coordinator-articles": "rights",
  advisor: "compass",
  "advisor-workload": "workload",
  "advisor-turnout": "voting",
  "advisor-risks": "rights",
  "advisor-leadership": "profile",
  admin: "settings",
  "admin-access": "profile",
  "admin-mfa": "settings",
  "admin-events": "events",
  "admin-form-templates": "forms",
  "admin-audit": "forms",
  vp: "hub",
  "vp-trend": "numbers",
  "vp-attention": "rights",
  "vp-leadership": "profile",
  "vp-priorities": "forms",
  "vp-events": "events",
};

export function NavGlyph({ name }) {
  const glyph = GLYPH_PATHS[name] || GLYPH_PATHS[GLYPH_ALIASES[name]] || GLYPH_PATHS.default;
  return (
    <svg className="nav-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {glyph}
    </svg>
  );
}
